import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const maxDuration = 60

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const family = searchParams.get('family')
    const productType = searchParams.get('productType')
    const productModel = searchParams.get('productModel')

    console.log('🔍 Fetching coatings filter options with filters:', { family, productType, productModel })

    // Build query with filters
    let query = supabase
      .from('coatings')
      .select('*')
      .limit(10000)

    // Apply filters if provided
    if (family) {
      query = query.eq('family', family)
    }
    if (productType) {
      query = query.eq('product_type', productType)
    }
    if (productModel) {
      query = query.eq('product_model', productModel)
    }

    const { data: products, error } = await query

    if (error) {
      console.error('❌ Database error:', error)
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${products?.length || 0} coatings products`)

    const families = new Set<string>()
    const productTypes = new Set<string>()
    const productModels = new Set<string>()

    products?.forEach((product: any) => {
      // Extract family
      const familyValue = product.family || product.Family || product.product_family || product.productFamily
      if (familyValue && String(familyValue).trim()) {
        families.add(String(familyValue).trim())
      }

      // Extract product type
      const typeValue = product.product_type || product.productType || product.type || product.Type || product.category || product.Category
      if (typeValue && String(typeValue).trim()) {
        productTypes.add(String(typeValue).trim())
      }

      // Extract product model
      const modelValue = product.product_model || product.productModel || product.model || product.Model || product.specification || product.Specification
      if (modelValue && String(modelValue).trim()) {
        productModels.add(String(modelValue).trim())
      }

      // Also check in all_attributes
      if (product.all_attributes) {
        try {
          let attributes: any = typeof product.all_attributes === 'string' 
            ? JSON.parse(product.all_attributes) 
            : product.all_attributes

          const attrFamily = attributes.family || attributes.Family || attributes.product_family || attributes.productFamily
          if (attrFamily && String(attrFamily).trim()) {
            families.add(String(attrFamily).trim())
          }

          const attrType = attributes.product_type || attributes.productType || attributes.type || attributes.Type
          if (attrType && String(attrType).trim()) {
            productTypes.add(String(attrType).trim())
          }

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

    console.log(`✅ Coatings filter options: ${familiesArray.length} families, ${productTypesArray.length} types, ${productModelsArray.length} models`)

    return NextResponse.json({
      success: true,
      families: familiesArray,
      productTypes: productTypesArray,
      productModels: productModelsArray
    })
  } catch (error: any) {
    console.error('❌ Error loading coatings filter options:', error)
    return NextResponse.json(
      {
        success: false,
        families: [],
        productTypes: [],
        productModels: [],
        error: error.message
      },
      { status: 500 }
    )
  }
}
