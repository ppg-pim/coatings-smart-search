import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    // First, get a sample coating to see what columns are available
    const { data: sampleData, error: sampleError } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)

    if (sampleError) {
      throw new Error(`Database error: ${sampleError.message}`)
    }

    const availableColumns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0]) 
      : []

    console.log('📊 Available columns:', availableColumns)

    // Fetch all coatings
    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(10000)

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} coatings`)

    // Extract unique values for filters
    const families = new Set<string>()
    const productTypes = new Set<string>()
    const productModels = new Set<string>()

    coatings?.forEach((coating: any) => {
      // Try multiple possible column names for Family
      const familyValue = coating.family || coating.Family || coating.product_family || coating.productFamily
      if (familyValue && String(familyValue).trim()) {
        families.add(String(familyValue).trim())
      }

      // Try multiple possible column names for Product Type
      const typeValue = coating.product_type || coating.productType || coating.type || coating.Type || coating.category || coating.Category
      if (typeValue && String(typeValue).trim()) {
        productTypes.add(String(typeValue).trim())
      }

      // Try multiple possible column names for Product Model
      const modelValue = coating.product_model || coating.productModel || coating.model || coating.Model
      if (modelValue && String(modelValue).trim()) {
        productModels.add(String(modelValue).trim())
      }

      // Also check in all_attributes if it exists
      if (coating.all_attributes) {
        try {
          let attributes: any = {}
          
          if (typeof coating.all_attributes === 'string') {
            attributes = JSON.parse(coating.all_attributes)
          } else if (typeof coating.all_attributes === 'object') {
            attributes = coating.all_attributes
          }

          // Check for family in attributes
          const attrFamily = attributes.family || attributes.Family || attributes.product_family || attributes.productFamily
          if (attrFamily && String(attrFamily).trim()) {
            families.add(String(attrFamily).trim())
          }

          // Check for type in attributes
          const attrType = attributes.product_type || attributes.productType || attributes.type || attributes.Type || attributes.category || attributes.Category
          if (attrType && String(attrType).trim()) {
            productTypes.add(String(attrType).trim())
          }

          // Check for product model in attributes
          const attrModel = attributes.product_model || attributes.productModel || attributes.model || attributes.Model
          if (attrModel && String(attrModel).trim()) {
            productModels.add(String(attrModel).trim())
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    })

    const familiesArray = Array.from(families).sort()
    const productTypesArray = Array.from(productTypes).sort()
    const productModelsArray = Array.from(productModels).sort()

    console.log(`✅ Found ${familiesArray.length} families, ${productTypesArray.length} product types, ${productModelsArray.length} product models`)
    console.log('📋 Families:', familiesArray.slice(0, 5))
    console.log('📋 Product Types:', productTypesArray.slice(0, 5))
    console.log('📋 Product Models:', productModelsArray.slice(0, 5))

    return NextResponse.json({
      success: true,
      families: familiesArray,
      productTypes: productTypesArray,
      productModels: productModelsArray,
      availableColumns: availableColumns,
      totalCoatings: coatings?.length || 0
    })

  } catch (error: any) {
    console.error('❌ Filter options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        availableColumns: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}
